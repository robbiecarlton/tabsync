import { render } from 'preact';

function Popup() {
  return (
    <main style={{ width: '320px', padding: '12px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '16px', margin: 0 }}>Tab Sync</h1>
      <p>Not set up.</p>
      <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
        Set up sync
      </button>
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
