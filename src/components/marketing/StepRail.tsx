const STEPS = [
  {
    n: "01",
    title: "Audit",
    body: "We quantify the gap between what your brand is earning on Amazon and what it could earn — written, sourced, signed off before anything visible happens.",
  },
  {
    n: "02",
    title: "Set up",
    body: "Brand Registry, listing hygiene, MAP policy. SKUs aligned with what resellers have already proven works on the platform.",
  },
  {
    n: "03",
    title: "Protect",
    body: "Monitoring, enforcement, updated wholesale agreements. The legal scaffolding that lets you move resellers off without burning relationships.",
  },
  {
    n: "04",
    title: "Transition",
    body: "Resellers sell through their inventory. You stock the shelf. Sequenced so the channel never goes dark mid-handoff.",
  },
  {
    n: "05",
    title: "Scale",
    body: "Train an in-house team or VA to operate the channel for the long run. You own the playbook and the people when we leave.",
  },
];

export default function StepRail() {
  return (
    <ol className="m-rail" aria-label="Five-step framework">
      {STEPS.map((s) => (
        <li key={s.n} className="step">
          <div className="n" aria-hidden>{s.n}</div>
          <div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
