export function Brand({ large = false }: { large?: boolean }) {
  return <img src="/logo.png" alt="Bagger" className={large ? "h-9 w-auto" : "h-6 w-auto"} />;
}
