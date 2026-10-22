/** Shown for API 404s. Deliberately identical for "missing" and "no access" (BR-01-02). */
export function NotFoundState() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page does not exist or you do not have access to it.
      </p>
    </div>
  );
}
