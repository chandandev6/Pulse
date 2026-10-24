import { Link, Navigate } from "react-router";
import { useMe } from "../api/queries";
import { Logo } from "../components/Logo";
import "../landing.css";

const GITHUB = "https://github.com/chandandev6/Pulse";
const COLUMNS = Array.from({ length: 12 }, (_, i) => `column-${i + 1}`);

// What the hero "monitor" plays once on load: a crash arrives, gets grouped, pages someone, gets acknowledged
const LOG = [
  { time: "03:12:07", kind: "event", text: "TypeError: cart is undefined", note: "checkout.js:42" },
  { time: "03:12:09", kind: "group", text: "214 events → 1 issue", note: "38 users hit" },
  { time: "03:12:10", kind: "incident", text: "Incident #128 opened", note: "critical" },
  { time: "03:12:10", kind: "page", text: "Paged Priya, on call", note: "push + SMS" },
  { time: "03:12:52", kind: "ack", text: "Priya acknowledged", note: "in 0:42" },
] as const;

const STEPS = [
  {
    title: "Capture",
    body: "Add the SDK and every uncaught exception, unhandled rejection and 5xx in Express or Fastify is reported with its stack trace, release, environment, user and route. Passwords, tokens and card numbers are scrubbed before anything is stored.",
    detail: "Pulse.init({ dsn })",
  },
  {
    title: "Group",
    body: "Each event is fingerprinted from its stack, so ten thousand copies of one crash become one issue with a count, a frequency chart and the users it hit. A resolved issue that comes back is flagged as a regression.",
    detail: "fingerprint → issue",
  },
  {
    title: "Page",
    body: "Alert rules decide what is worth waking someone for: a new issue, a regression, a critical error, more than N events in X minutes. Pulse opens an incident and notifies whoever the on-call schedule names, by email, SMS, push or webhook.",
    detail: "rule → incident → on-call",
  },
  {
    title: "Escalate",
    body: "Nobody acknowledged before the timeout? Pulse moves to the next level of the escalation policy, and the next, until someone takes it. Every page, escalation and acknowledgement is kept on the incident's timeline.",
    detail: "level 1 → level 2 → …",
  },
];

// Heartbeat baseline with three error spikes in the middle (drawn in a 1000×120 box)
const BEAT = "l14 0 6 -10 6 18 6 -8 8 0";
const LINE = `M0 70 ${Array(6).fill(`h40 ${BEAT}`).join(" ")} h30 l8 -60 8 100 8 -66 6 26 h18 l8 -52 8 90 8 -38 h20 l6 -64 8 106 8 -42 h40 ${Array(4).fill(`h40 ${BEAT}`).join(" ")} H1000`;

// The public front page. Logged-in people go straight to their dashboard.
export function LandingPage() {
  const me = useMe();
  if (me.data) return <Navigate to="/app" replace />;

  return (
    <div className="landing">
      <div className="l-columns" aria-hidden="true">
        {COLUMNS.map((column) => (
          <span key={column} />
        ))}
      </div>

      <header className="l-header">
        <Link to="/" className="l-brand">
          <Logo size={26} /> Pulse
        </Link>
        <nav className="l-nav" aria-label="Main">
          <a href="#how">
            <span>01</span> How it works
          </a>
          <a href="#sdk">
            <span>02</span> SDK
          </a>
          <a href="#self-host">
            <span>03</span> Self-host
          </a>
          <a href={GITHUB}>
            <span>04</span> GitHub
          </a>
        </nav>
        <div className="l-header-actions">
          <Link to="/login" className="l-link">
            Log in
          </Link>
          <Link to="/signup" className="l-button l-button-small">
            Start free
          </Link>
        </div>
      </header>

      <main>
        <section className="l-hero" aria-labelledby="hero-title">
          <p className="l-eyebrow">Error tracking + on-call paging, self-hosted</p>
          <h1 id="hero-title" className="l-headline">
            <span>Errors in.</span>
            <span>The right person</span>
            <span>
              paged<em>.</em>
            </span>
          </h1>
          <div className="l-hero-side">
            <p className="l-lede">
              Pulse catches every crash in your app, folds the duplicates into one issue, and wakes
              whoever is on call. If they don't answer, it wakes the next person.
            </p>
            <div className="l-actions">
              <Link to="/signup" className="l-button">
                Start monitoring, free{" "}
                <span className="l-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
              <a href="#self-host" className="l-link">
                or run it on your own server
              </a>
            </div>
          </div>

          <figure className="l-monitor">
            <figcaption className="l-monitor-bar">
              <span>shop-api / production</span>
              <span className="l-live">live</span>
            </figcaption>
            <svg
              className="l-ecg"
              viewBox="0 0 1000 120"
              role="img"
              aria-label="A steady heartbeat line that spikes three times when errors arrive"
            >
              <defs>
                {/* The line is ink, except the three error spikes (x 510–624), which are tangerine */}
                <linearGradient id="ecg-ink" gradientUnits="userSpaceOnUse" x1="0" x2="1000">
                  <stop offset="0.5" className="l-ecg-ink" />
                  <stop offset="0.505" className="l-ecg-hot" />
                  <stop offset="0.63" className="l-ecg-hot" />
                  <stop offset="0.635" className="l-ecg-ink" />
                </linearGradient>
              </defs>
              <path className="l-ecg-line" d={LINE} pathLength={1} stroke="url(#ecg-ink)" />
            </svg>
            <ol className="l-log" aria-label="What Pulse did">
              {LOG.map((row, i) => (
                <li
                  key={row.kind}
                  className={`l-log-${row.kind}`}
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <time>{row.time}</time>
                  <span className="l-log-kind">{row.kind}</span>
                  <span className="l-log-text">{row.text}</span>
                  <span className="l-log-note">{row.note}</span>
                </li>
              ))}
            </ol>
          </figure>
        </section>

        <section id="how" className="l-section" aria-labelledby="how-title">
          <div className="l-section-head">
            <p className="l-index">01</p>
            <h2 id="how-title">How it works</h2>
            <p className="l-section-intro">
              From a thrown error to a person fixing it, in four steps you don't have to think
              about.
            </p>
          </div>
          <ol className="l-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="l-step">
                <span className="l-step-num">01.{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <code>{step.detail}</code>
              </li>
            ))}
          </ol>
        </section>

        <section className="l-statement" aria-label="One issue, not ten thousand emails">
          <p>
            <span className="l-statement-big">1 issue.</span>
            <span className="l-statement-small">Not 10,000 emails at 3 a.m.</span>
          </p>
        </section>

        <section id="sdk" className="l-section l-split" aria-labelledby="sdk-title">
          <div className="l-section-head">
            <p className="l-index">02</p>
            <h2 id="sdk-title">Two lines in your app</h2>
            <p className="l-section-intro">
              The JavaScript SDK runs in Node.js and the browser. Create a project, copy its DSN
              from Settings, and errors start arriving. Anything that can send an HTTP POST can
              report too: see the <a href={`${GITHUB}/blob/main/docs/api.md`}>API reference</a>.
            </p>
          </div>
          <pre className="l-code">
            <code>
              <span className="c-k">import</span> Pulse <span className="c-k">from</span>{" "}
              <span className="c-s">"@pulse/sdk"</span>;{"\n\n"}
              Pulse.<span className="c-f">init</span>({"{\n"}
              {"  "}dsn:{" "}
              <span className="c-s">"https://&lt;key&gt;@pulse-log.app/&lt;project&gt;"</span>,
              {"\n"}
              {"  "}environment: <span className="c-s">"production"</span>,{"\n"}
              {"  "}release: <span className="c-s">"1.4.2"</span>,{"\n"}
              {"}"});{"\n\n"}
              <span className="c-c">{"// Express: after your routes"}</span>
              {"\n"}
              app.<span className="c-f">use</span>(Pulse.
              <span className="c-f">expressErrorHandler</span>());
            </code>
          </pre>
        </section>

        <section id="self-host" className="l-section l-split" aria-labelledby="self-host-title">
          <div className="l-section-head">
            <p className="l-index">03</p>
            <h2 id="self-host-title">Your errors stay on your server</h2>
            <p className="l-section-intro">
              One Docker Compose file runs everything: the dashboard, the API, the worker,
              PostgreSQL and Redis. 1 CPU and 2 GB of RAM is enough to start. Upgrading is{" "}
              <code>git pull</code> and the same command again. Migrations run by themselves.
            </p>
            <a href={`${GITHUB}/blob/main/docs/self-hosting.md`} className="l-link">
              Read the self-hosting guide →
            </a>
          </div>
          <pre className="l-code">
            <code>
              <span className="c-p">$</span> git clone {GITHUB}.git{"\n"}
              <span className="c-p">$</span> cd Pulse && cp .env.prod.example .env.prod{"\n"}
              <span className="c-p">$</span> docker compose --env-file .env.prod \{"\n"}
              {"    "}-f docker-compose.prod.yml up -d --build{"\n\n"}
              <span className="c-c">{"# open http://localhost:8080 and sign up"}</span>
            </code>
          </pre>
        </section>

        <section className="l-final" aria-labelledby="final-title">
          <h2 id="final-title">The next crash is already on its way.</h2>
          <div className="l-actions">
            <Link to="/signup" className="l-button">
              Create your account{" "}
              <span className="l-arrow" aria-hidden="true">
                →
              </span>
            </Link>
            <Link to="/login" className="l-link">
              I already have one
            </Link>
          </div>
        </section>
      </main>

      <footer className="l-footer">
        <div className="l-footer-brand">
          <Logo size={22} /> Pulse
          <p>Self-hosted error tracking, incidents and on-call.</p>
        </div>
        <nav className="l-footer-nav" aria-label="Footer">
          <div>
            <h2>Product</h2>
            <a href="#how">How it works</a>
            <a href="#sdk">SDK</a>
            <a href="#self-host">Self-host</a>
          </div>
          <div>
            <h2>Project</h2>
            <a href={GITHUB}>Source on GitHub</a>
            <a href={`${GITHUB}/blob/main/docs/self-hosting.md`}>Self-hosting guide</a>
            <a href={`${GITHUB}/blob/main/docs/api.md`}>API reference</a>
          </div>
          <div>
            <h2>Account</h2>
            <Link to="/signup">Sign up</Link>
            <Link to="/login">Log in</Link>
          </div>
        </nav>
        <p className="l-footer-wordmark" aria-hidden="true">
          Pulse
        </p>
      </footer>
    </div>
  );
}
