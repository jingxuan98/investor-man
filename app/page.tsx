import SearchBar from "@/components/SearchBar";
import GeminiKeyButton from "@/components/GeminiKeyButton";
import Logo from "@/components/Logo";

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-page p-8">
      <div className="absolute right-6 top-6">
        <GeminiKeyButton />
      </div>
      <h1>
        <Logo size={56} />
      </h1>
      <p className="text-ink2">Intrinsic value, quality grades & AI research for US stocks</p>
      <SearchBar size="lg" className="w-full max-w-md" />
    </main>
  );
}
