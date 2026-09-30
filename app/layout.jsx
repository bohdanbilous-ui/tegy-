import "./globals.css";

export const metadata = {
  title: "Allocate · переведення, табель, ЗП",
  description: "Облік переведень співробітників, табель залученості, фін. облік і відомості ЗП",
};

export default function RootLayout({ children }) {
  return (
    <html lang="uk">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
