function copyToClipboard(text) {
  try {
      navigator.clipboard.writeText(text);
  } catch (e) {
    alert('Failed to copy to clipboard: ' + e);
    console.error(e);
  }
}

function createWebSocket(url, onmessage) {
  let ws;
  let reconnectInterval = 1000; // 1 second
  let maxRetries = 10;
  let retries = 0;
  connect();
  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      console.log('✅ Connected');
      retries = 0; // reset on success
    };
    ws.onmessage = onmessage;
    ws.onclose = (event) => {
      console.warn('⚠️ Disconnected:', event.reason);
      if (retries < maxRetries) {
        setTimeout(connect, reconnectInterval);
        retries++;
        reconnectInterval *= 2; // exponential backoff
      } else {
        console.error('❌ Max retries reached');
      }
    };
    ws.onerror = (err) => {
      console.error('💥 WebSocket error:', err.message);
      ws.close(); // trigger onclose
    };
  }
}

const loadSpinner = document.getElementById('load-spinner');
const reloadButton = document.getElementById('reload-button');

createWebSocket('/ws', (event) => {
  switch (event.data) {
    case 'FEED_UPDATE_STARTED':
    case 'FEEDS_UPDATE_STARTED':
    case 'FEED_UPDATE_RUNNING':
    case 'FEEDS_UPDATE_RUNNING':
      loadSpinner.hidden = false;
      reloadButton.hidden = true;
      break;
    case 'FEED_UPDATE_FINISHED':
    case 'FEEDS_UPDATE_FINISHED':
      loadSpinner.hidden = true;
      reloadButton.hidden = false;
      break;
  }
});