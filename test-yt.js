const { LiveChat } = require('youtube-chat');

async function test() {
  const liveChatHandle = new LiveChat({ handle: '@nickeh30' });
  
  liveChatHandle.on('start', (liveId) => {
    console.log('Started YT:', liveId);
  });

  liveChatHandle.on('chat', (chatItem) => {
    console.log('YT Chat raw:', JSON.stringify(chatItem));
  });

  await liveChatHandle.start();
  
  setTimeout(() => {
    liveChatHandle.stop();
  }, 5000);
}
test();
