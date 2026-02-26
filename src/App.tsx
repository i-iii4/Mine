export function App() {
  return (
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="p-4 text-sm font-semibold uppercase tracking-wider text-neutral-500">
          Local Arena
        </div>
      </aside>
      <main className="flex flex-1 items-center justify-center">
        <p className="text-neutral-400">No vault selected</p>
      </main>
    </div>
  );
}
