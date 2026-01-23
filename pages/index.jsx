import { useEffect } from 'react';

export default function Index() {
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.location.replace('/game');
    }
  }, []);
  return <p>Redirecting to /game…</p>;
}
