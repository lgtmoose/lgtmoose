import type { Plan } from "./plan.js";

export function AccountHeader({ name, plan }: { name: string; plan: Plan }) {
  const label = plan === "team" ? "Team" : plan === "pro" ? "Pro" : "Free";
  return (
    <h1>
      {name} <span className="plan">{label}</span>
    </h1>
  );
}
