export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse bg-page p-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-64 rounded bg-track" />
          <div className="h-5 w-40 rounded bg-track" />
        </div>
        <div className="h-9 w-80 rounded-lg bg-track" />
      </header>
      <div className="card mb-8 flex flex-col divide-y divide-line overflow-hidden sm:flex-row sm:divide-x sm:divide-y-0">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-1 space-y-2 px-6 py-5">
            <div className="h-3 w-20 rounded bg-track" />
            <div className="h-7 w-24 rounded bg-track" />
          </div>
        ))}
      </div>
      <div className="mb-4 h-6 w-32 rounded bg-track" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card h-20 p-4">
            <div className="h-full w-full rounded bg-track" />
          </div>
        ))}
      </div>
    </div>
  );
}
