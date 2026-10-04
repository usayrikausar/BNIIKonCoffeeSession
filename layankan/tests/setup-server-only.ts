// "server-only" throws outside a React Server Components bundler; tests run in plain Node.
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
