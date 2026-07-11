import Link from "next/link";

export default function TickerNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-page p-8 text-center">
      <h1 className="text-3xl font-bold text-ink">Ticker not found</h1>
      <p className="max-w-md text-ink2">
        We couldn&apos;t find data for that ticker. Double-check the symbol and try again.
      </p>
      <Link href="/" className="btn btn-blue text-lg">
        Back home
      </Link>
    </main>
  );
}
