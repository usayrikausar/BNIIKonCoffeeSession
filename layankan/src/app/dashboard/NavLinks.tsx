"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-3">
      {items.map((i) => {
        const active = path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-brand-50 text-brand-700" : "text-zinc-600 hover:bg-zinc-100"}`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
