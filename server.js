const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');
const { WebcastPushConnection } = require('tiktok-live-connector');
const fetch = require('node-fetch');
const { LiveChat } = require('youtube-chat');

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
}

function formatTwitchMessage(message, emotes) {
  if (!emotes) return escapeHTML(message);
  const replacements = [];
  for (const id in emotes) {
    emotes[id].forEach(pos => {
      const [start, end] = pos.split('-');
      replacements.push({ id, start: parseInt(start), end: parseInt(end) });
    });
  }
  replacements.sort((a, b) => a.start - b.start);
  
  let html = '';
  let lastIndex = 0;
  for (const rep of replacements) {
    if (rep.start < lastIndex) continue;
    html += escapeHTML(message.substring(lastIndex, rep.start));
    html += `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${rep.id}/default/dark/1.0" style="vertical-align: middle; height: 1.5em; display: inline-block;">`;
    lastIndex = rep.end + 1;
  }
  html += escapeHTML(message.substring(lastIndex));
  return html;
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the root directory so index.html works
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
  let twitchClient, tiktokConnector, ytChat;
  let tiktokReconnectTimeout = null;
  let isSocketConnected = true;

  socket.on('subscribe', (channels) => {
    // Clean up old connections safely for this user
    clearTimeout(tiktokReconnectTimeout);
    try { twitchClient?.disconnect(); } catch(e) {}
    try { tiktokConnector?.disconnect(); } catch(e) {}
    try { if (ytChat) ytChat.stop(); } catch(e) {}

    // Twitch
    if (channels.twitch?.trim()) {
      try {
        twitchClient = new tmi.Client({ channels: [channels.twitch.toLowerCase()] });
        twitchClient.connect();
        twitchClient.on('message', (channel, tags, message) => {
          socket.emit('message', {
            platform: 'twitch',
            user: tags['display-name'] || tags.username,
            message: formatTwitchMessage(message, tags.emotes),
            color: tags.color || '#9146FF'
          });
        });

        twitchClient.on('subscription', (channel, username, method, message, userstate) => {
          socket.emit('message', { platform: 'twitch', user: username, message: `🎉 Just subscribed!`, color: '#9146FF', isSystem: true });
        });
        twitchClient.on('resub', (channel, username, months, message, userstate, methods) => {
          socket.emit('message', { platform: 'twitch', user: username, message: `🎉 Resubscribed for ${months} months!`, color: '#9146FF', isSystem: true });
        });
        twitchClient.on('subgift', (channel, username, streakMonths, recipient, methods, userstate) => {
          socket.emit('message', { platform: 'twitch', user: username, message: `🎁 Gifted a sub to ${recipient}!`, color: '#9146FF', isSystem: true });
        });
      } catch (e) { console.error('Twitch error:', e); }
    }

    // TikTok – via the direct connector
    if (channels.tiktok?.trim()) {
      try {
        const username = channels.tiktok.trim().replace('@', '');
        tiktokConnector = new WebcastPushConnection(username);

        tiktokConnector.on('chat', (data) => {
          socket.emit('message', {
            platform: 'tiktok',
            user: data.uniqueId || 'TikToker',
            message: escapeHTML(data.comment || ''),
            color: '#00F2FE'
          });
        });

        tiktokConnector.on('gift', (data) => {
          socket.emit('message', {
            platform: 'tiktok',
            user: data.uniqueId,
            message: `🎁 ${escapeHTML(data.giftName)} x${data.repeatCount}`,
            color: '#00F2FE',
            isSystem: true
          });
        });

        tiktokConnector.on('follow', (data) => {
          socket.emit('message', { platform: 'tiktok', user: data.uniqueId, message: `👤 Followed the channel!`, color: '#00F2FE', isSystem: true });
        });

        tiktokConnector.on('subscribe', (data) => {
          socket.emit('message', { platform: 'tiktok', user: data.uniqueId, message: `🎉 Subscribed to the channel!`, color: '#00F2FE', isSystem: true });
        });

        const backoffDelays = [30000, 45000, 60000, 60000, 120000];
        let attempt = 0;

        const connectTikTok = () => {
          if (!isSocketConnected) return;
          
          tiktokConnector.connect()
            .then(() => {
              console.log(`Connected to TikTok: ${username}`);
              attempt = 0; // Reset on success
            })
            .catch(err => {
              console.error(`TikTok connection failed (Attempt ${attempt + 1}):`, err.message || err);
              
              if (attempt < backoffDelays.length && isSocketConnected) {
                const delay = backoffDelays[attempt];
                console.log(`Retrying TikTok in ${delay / 1000} seconds...`);
                socket.emit('message', { platform: 'tiktok', user: 'System', message: `TikTok connection failed. Retrying in ${delay / 1000} seconds...`, color: '#00F2FE', isSystem: true });
                
                tiktokReconnectTimeout = setTimeout(connectTikTok, delay);
                attempt++;
              } else if (isSocketConnected) {
                socket.emit('message', { platform: 'tiktok', user: 'System', message: `TikTok connection failed after 5 attempts. Halting to prevent IP block.`, color: '#FF0000', isSystem: true });
              }
            });
        };
        
        connectTikTok();
      } catch (e) {
        console.error('TikTok proxy error:', e);
      }
    }

    // YouTube – safe via youtube-chat
    if (channels.youtube?.trim()) {
      try {
        let handleOrId = channels.youtube.trim();
        // Assume handle if no prefix and not a channel ID format
        if (!handleOrId.startsWith('@') && handleOrId.length < 24) {
          handleOrId = '@' + handleOrId;
        }

        const ytOptions = handleOrId.startsWith('@') ? { handle: handleOrId } : { channelId: handleOrId };
        ytChat = new LiveChat(ytOptions);

        ytChat.on('chat', (chatItem) => {
          let messageHtml = '';
          if (Array.isArray(chatItem.message)) {
            chatItem.message.forEach(part => {
              if (part.url) {
                messageHtml += `<img src="${part.url}" alt="${part.alt || ''}" style="vertical-align: middle; height: 1.5em; display: inline-block;">`;
              } else if (part.text) {
                messageHtml += escapeHTML(part.text);
              }
            });
          }

          let isSystem = false;
          let systemPrefix = '';

          if (chatItem.superchat) {
            isSystem = true;
            systemPrefix = `💎 <b>SuperChat ${escapeHTML(chatItem.superchat.amount)}</b>: `;
          } else if (chatItem.isMembership) {
            isSystem = true;
            systemPrefix = `🌟 <b>New Member!</b> `;
          }

          socket.emit('message', {
            platform: 'youtube',
            user: chatItem.author?.name || 'YouTuber',
            message: systemPrefix + messageHtml,
            color: '#FF0000',
            isSystem: isSystem
          });
        });

        ytChat.on('error', (err) => console.error('YouTube listener error:', err.message || err));
        
        ytChat.start().then(ok => {
          if(ok) console.log(`Connected to YouTube: ${handleOrId}`);
        }).catch(err => console.error('YouTube start error:', err.message || err));

      } catch (e) { console.error('YouTube error:', e); }
    }
  });

  socket.on('disconnect', () => {
    isSocketConnected = false;
    clearTimeout(tiktokReconnectTimeout);
    try { twitchClient?.disconnect(); } catch(e) {}
    try { tiktokConnector?.disconnect(); } catch(e) {}
    try { if (ytChat) ytChat.stop(); } catch(e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat running on port ${PORT}`));