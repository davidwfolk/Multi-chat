const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const tmi = require('tmi.js');
const { WebcastPushConnection } = require('tiktok-live-connector');
const fetch = require('node-fetch');
const { LiveChat } = require('youtube-chat');

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

  socket.on('subscribe', (channels) => {
    // Clean up old connections safely for this user
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
            message,
            color: tags.color || '#9146FF'
          });
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
            message: data.comment || '',
            color: '#00F2FE'
          });
        });

        tiktokConnector.on('gift', (data) => {
          socket.emit('message', {
            platform: 'tiktok',
            user: data.uniqueId,
            message: `🎁 ${data.giftName} x${data.repeatCount}`,
            color: '#00F2FE'
          });
        });

        tiktokConnector.connect()
          .then(() => console.log(`Connected to TikTok: ${username}`))
          .catch(err => console.error('TikTok connection failed', err));
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
          const messageText = (chatItem.message || []).map(m => m.text || m.emojiText || m.alt || '').join('');
          socket.emit('message', {
            platform: 'youtube',
            user: chatItem.author?.name || 'YouTuber',
            message: messageText,
            color: '#FF0000'
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
    try { twitchClient?.disconnect(); } catch(e) {}
    try { tiktokConnector?.disconnect(); } catch(e) {}
    try { if (ytChat) ytChat.stop(); } catch(e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat running on port ${PORT}`));