import { redirect } from "next/navigation";

// `/` lands on `/world`. Authed users continue into their gallery;
// unauth users are bounced to /login by the world page itself.
// No more legacy /ask landing.
export default function Home() {
  redirect("/world");
}
