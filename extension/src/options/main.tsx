import { render } from 'preact';

function Options() {
  return (
    <main style={{ maxWidth: '640px', margin: '24px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Tab Sync options</h1>
      <p>Setup arrives in milestone 3.</p>
    </main>
  );
}

render(<Options />, document.getElementById('app')!);
