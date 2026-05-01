const ITEMS = [
  {
    q: "What if resellers retaliate?",
    a: "They rarely do — they're arbitrageurs, not partners, and they move on to the next brand. We sequence the transition with notice, sell-out windows, and updated wholesale agreements so the legal footing is clean before anything visible happens. In 100% of the engagements we've run, the resellers eventually walked, and the brand kept the customer.",
  },
  {
    q: "Won't this create operational complexity?",
    a: "Less than you think. We do the heavy lifting — Brand Registry, listing rebuilds, FBA setup, advertising. By the end of the engagement you have a trained VA or in-house specialist running it day to day. You go from a channel you don't control to a channel that runs itself.",
  },
  {
    q: "What if I lose wholesale relationships?",
    a: "Resellers aren't building long-term demand for your brand — they're capturing the demand that's already there. Real wholesale partners (the ones who actually drive volume in their own channels) tend to be supportive once you show them the MAP policy and brand standards. The ones who push back were arbitraging you anyway.",
  },
  {
    q: "Is this cost-effective for smaller brands?",
    a: "Often yes. Even brands under $1M in wholesale revenue can see meaningful profit growth when the retail margin lands on their P&L instead of someone else's. The math scales down before it scales up. The free audit will tell you whether it's worth doing for your specific category and velocity.",
  },
  {
    q: "I already have an Amazon presence — does that matter?",
    a: "Perfect. It means demand is already proven on the platform. We just need to redirect that demand from third-party resellers onto a listing you operate. Existing presence usually accelerates the timeline rather than complicating it.",
  },
];

export default function Objections() {
  return (
    <div className="m-accordion" role="list">
      {ITEMS.map((item) => (
        <details key={item.q}>
          <summary>
            <span>{item.q}</span>
            <span className="plus" aria-hidden>+</span>
          </summary>
          <div className="body">{item.a}</div>
        </details>
      ))}
    </div>
  );
}
