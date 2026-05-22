const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');
const { WebcastPushConnection } = require('tiktok-live-connector');
const fetch = require('node-fetch');

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
  let ytPollingTimeout = null;
  let isSocketConnected = true;

  socket.on('subscribe', (channels) => {
    // Clean up old connections safely for this user
    clearTimeout(tiktokReconnectTimeout);
    clearTimeout(ytPollingTimeout);
    try { twitchClient?.disconnect(); } catch(e) {}
    try { tiktokConnector?.disconnect(); } catch(e) {}

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

    // YouTube – via Official Data API v3
    if (channels.youtube?.trim()) {
      const ytApiKey = channels.youtubeApiKey?.trim();
      const ytInput = channels.youtube.trim();

      async function getLiveChatId() {
        if (!ytApiKey) throw new Error("YouTube API Key is missing. Please add it to Settings.");
        let videoId = null;

        if (ytInput.length === 11 && !ytInput.startsWith('@')) {
          videoId = ytInput;
        } else {
          let channelId = ytInput;
          if (!ytInput.startsWith('UC')) {
            let handle = ytInput.startsWith('@') ? ytInput : '@' + ytInput;
            const res = await fetch(`https://youtube.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${ytApiKey}`);
            const data = await res.json();
            if (!data.items || data.items.length === 0) throw new Error("Could not find channel for handle " + handle);
            channelId = data.items[0].id;
          }
          
          const searchRes = await fetch(`https://youtube.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&eventType=live&type=video&key=${ytApiKey}`);
          const searchData = await searchRes.json();
          if (!searchData.items || searchData.items.length === 0) throw new Error("No active live stream found for this channel.");
          videoId = searchData.items[0].id.videoId;
        }

        const vidRes = await fetch(`https://youtube.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${ytApiKey}`);
        const vidData = await vidRes.json();
        if (!vidData.items || vidData.items.length === 0) throw new Error("Video not found");
        if (!vidData.items[0].liveStreamingDetails || !vidData.items[0].liveStreamingDetails.activeLiveChatId) throw new Error("Live chat not active on this video");
        
        return vidData.items[0].liveStreamingDetails.activeLiveChatId;
      }

      async function pollYouTube(liveChatId, pageToken) {
        if (!isSocketConnected) return;

        let url = `https://youtube.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${ytApiKey}`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        try {
          const res = await fetch(url);
          if (!res.ok) {
             const errorText = await res.text();
             throw new Error(`HTTP ${res.status}: ${errorText || 'Empty Response'}`);
          }
          const data = await res.json();
          
          if (data.error) {
             console.error("YouTube API Error:", data.error.message);
             socket.emit('message', { platform: 'youtube', user: 'System', message: `YouTube API Error: ${data.error.message}`, color: '#FF0000', isSystem: true });
             return;
          }

          if (data.items) {
             let itemsToProcess = data.items;
             
             // On the very first load (pageToken is null), only grab the last 10 messages to prevent flooding
             if (!pageToken && itemsToProcess.length > 10) {
                 itemsToProcess = itemsToProcess.slice(-10);
             }

             itemsToProcess.forEach(item => {
               const snippet = item.snippet || {};
               const author = item.authorDetails || {};
               
               let messageText = snippet.displayMessage || '';
               let isSystem = false;
               let systemPrefix = '';

               if (snippet.type === 'superChatEvent' && snippet.superChatDetails) {
                  isSystem = true;
                  systemPrefix = `💎 <b>SuperChat ${escapeHTML(snippet.superChatDetails.amountDisplayString)}</b>: `;
                  messageText = snippet.superChatDetails.userComment || '';
               } else if (snippet.type === 'newSponsorEvent') {
                  isSystem = true;
                  systemPrefix = `🌟 <b>New Member!</b> `;
               }

               socket.emit('message', {
                  platform: 'youtube',
                  user: author.displayName || 'YouTuber',
                  message: systemPrefix + escapeHTML(messageText),
                  color: '#FF0000',
                  isSystem: isSystem
               });
             });
          }

          const nextToken = data.nextPageToken || pageToken;
          const delay = data.pollingIntervalMillis || 3000;
          
          ytPollingTimeout = setTimeout(() => pollYouTube(liveChatId, nextToken), delay);
        } catch(e) {
          console.error("YouTube poll error:", e);
          socket.emit('message', { platform: 'youtube', user: 'System', message: `Internal Error: ${e.message}`, color: '#FF0000', isSystem: true });
          ytPollingTimeout = setTimeout(() => pollYouTube(liveChatId, pageToken), 5000);
        }
      }

      getLiveChatId().then(chatId => {
         console.log("Connected to YouTube Live Chat");
         socket.emit('message', { platform: 'youtube', user: 'System', message: `Successfully connected to YouTube Data API!`, color: '#FF0000', isSystem: true });
         pollYouTube(chatId, null);
      }).catch(err => {
         console.error("YouTube start error:", err.message);
         socket.emit('message', { platform: 'youtube', user: 'System', message: `YouTube Connection Error: ${err.message}`, color: '#FF0000', isSystem: true });
      });
    }
  });

  socket.on('disconnect', () => {
    isSocketConnected = false;
    clearTimeout(tiktokReconnectTimeout);
    clearTimeout(ytPollingTimeout);
    try { twitchClient?.disconnect(); } catch(e) {}
    try { tiktokConnector?.disconnect(); } catch(e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat running on port ${PORT}`));