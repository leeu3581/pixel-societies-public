import type { Metadata } from "next";
import GraphView from "./GraphView";

export const metadata: Metadata = {
  title: "Crowdsource Intelligence — Graph",
  description: "Force-directed graph of every wiki page and its links.",
};

const BACKEND_HOST =
  process.env.NEXT_PUBLIC_CHAT_BACKEND_HOST || "localhost:4000";

export default function GraphPage() {
  return <GraphView backendHost={BACKEND_HOST} />;
}
