import { CATEGORIES, factors } from "@kc/shared";

/** Public page: exactly how impact numbers are produced, and what they do not claim. English only for reviewers. */
export function Methodology() {
  return (
    <main className="prose">
      <p>
        <a href="/">← Kabadi Connect</a>
      </p>
      <h1>How we count impact</h1>
      <p>
        Every number on the dashboard comes from pickups that a collector confirmed in the app. Nothing is extrapolated from sign-ups or estimates.
      </p>

      <h2>Three levels of evidence</h2>
      <ol>
        <li>
          <strong>Estimated</strong>: the household picks a rough weight bucket. Used only to plan routes. <em>Never counted as impact.</em>
        </li>
        <li>
          <strong>Collector-measured</strong>: the collector enters the weight they actually weighed at the door. This is what the kg totals, CO₂e and payouts use.
        </li>
        <li>
          <strong>Household-confirmed</strong>: the household also tapped that the recorded weights look right. The dashboard shows how many kg reached this level.
        </li>
      </ol>

      <h2>Formulas</h2>
      <ul>
        <li>kg diverted = sum of collector-measured kg.</li>
        <li>CO₂e avoided = sum over materials of (kg × factor below).</li>
        <li>Route saving = 1 − (km of the optimised route ÷ km if visited in request order). Distances are straight-line between points, not road distance.</li>
        <li>Payout = measured kg × the collector's posted rate for the material.</li>
      </ul>

      <h2>Emission factors (kg CO₂e per kg)</h2>
      <table>
        <thead>
          <tr>
            <th>Material</th>
            <th>Factor used</th>
            <th>Basis</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((c) => (
            <tr key={c}>
              <td>{c}</td>
              <td>
                {factors.co2PerKg[c]} <small>{factors.verifiedCo2[c] ? "sourced" : "placeholder"}</small>
              </td>
              <td>{factors.anchors[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <strong>Avoided emissions = landfilling minus recycling</strong>, using the net figures in EPA WARM. {factors.note}
      </p>
      <p className="error">
        These are US factors applied to Indian conditions, so treat CO₂e as an estimate. If the true factors were half of these, the CO₂e total would halve; kg and rupees would not change.
      </p>
      <ul>
        {factors.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} rel="noreferrer" target="_blank">
              {s.title}
            </a>
          </li>
        ))}
      </ul>

      <h2>Default rates (₹ per kg, as of {factors.ratesAsOf})</h2>
      <table>
        <thead>
          <tr>
            <th>Material</th>
            <th>Rate</th>
            <th>Basis</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((c) => (
            <tr key={c}>
              <td>{c}</td>
              <td>
                ₹{factors.ratePerKg[c]} <small>{factors.verifiedRate[c] ? "from price lists" : "placeholder"}</small>
              </td>
              <td>{factors.rateAnchors[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        {factors.rateSources.map((s) => (
          <li key={s.url}>
            <a href={s.url} rel="noreferrer" target="_blank">
              {s.title}
            </a>
          </li>
        ))}
      </ul>

      <h2>What we do not claim</h2>
      <ul>
        <li>
          <strong>No counterfactual.</strong> Informal collectors already recycle part of this material. We measure what is recorded through the app, not what would not have happened
          otherwise.
        </li>
        <li>Landfill diversion assumes the recorded material reaches recyclers; we do not yet track downstream sale.</li>
        <li>Rates vary a lot by buyer, quality and quantity; collectors can post their own, and totals from earlier pickups keep the numbers recorded at the time.</li>
      </ul>

      <h2>Privacy</h2>
      <p>
        Monthly statements and impact totals contain no household addresses or phone numbers. Photo estimates are analysed in memory and never stored. Voice clips are transcribed and
        discarded.
      </p>
    </main>
  );
}
