// app/scan/page.jsx — a Server Component rendering the client scanner.
import ScannerClient from './ScannerClient';

export const metadata = { title: 'Marker scanner' };

export default function Page() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Marker scanner</h1>
      <p>Point the camera at a DICT_5X5_50 marker.</p>
      <ScannerClient dictionary="DICT_5X5_50" halfResolution />
    </main>
  );
}
