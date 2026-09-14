/** Shown while a conversation's messages are fetched on the server. */
export default function Loading() {
  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className={`flex ${i % 2 ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`h-16 animate-pulse rounded-2xl bg-surface ${
                i % 2 ? "w-1/2" : "w-2/3"
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
