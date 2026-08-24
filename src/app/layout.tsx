import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Supabase Manager',
  description: 'Self-hosted Supabase project manager',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
