import type { WireCandidate, WireInspection, WireTrace } from "@rag-book/api-contract";
import {
  budgetShare,
  describeFate,
  describeMove,
  describeUsage,
  formatMs,
  formatScore,
  pagesLabel,
  rerankChangedAnything,
  rerankMove,
  summaryPairs,
} from "../inspector/inspector-logic.js";

interface InspectorPanelProps {
  readonly inspection: WireInspection;
  readonly trace: WireTrace | undefined;
}

const GLYPH = { cut: "✕", same: "＝", up: "▲", down: "▼" } as const;

function Candidate({ candidate }: { candidate: WireCandidate }) {
  const move = rerankMove(candidate);
  const place =
    move.kind === "up" || move.kind === "down"
      ? `${move.from.toString()}→${move.to.toString()}`
      : "";
  return (
    <li className={`candidate candidate-${candidate.fate}`}>
      <div className="candidate-head">
        <strong>#{candidate.rank}</strong>
        <span title="The retriever's score for it">{formatScore(candidate.score)}</span>
        <span>{pagesLabel(candidate)}</span>
        {candidate.source === undefined ? null : (
          <span className="chip chip-used">[{candidate.source}]</span>
        )}
      </div>
      {candidate.sectionPath.length === 0 ? null : (
        <p className="candidate-section">{candidate.sectionPath.join(" › ")}</p>
      )}
      <p className="candidate-snippet">{candidate.snippet}</p>
      <ul className="chips" aria-label="How it was found">
        {candidate.foundBy.length === 0 ? (
          <li className="chip chip-quiet">{candidate.retriever}</li>
        ) : (
          candidate.foundBy.map((found) => (
            <li
              key={found.retriever}
              className="chip"
              title={`${found.retriever} ranked it ${found.rank.toString()}th, score ${formatScore(found.score)}`}
            >
              {found.retriever} #{found.rank}
            </li>
          ))
        )}
        <li className={`chip chip-${move.kind}`} title={describeMove(move)}>
          <span aria-hidden="true">
            {GLYPH[move.kind]} {place}
          </span>
          <span className="visually-hidden">{describeMove(move)}</span>
        </li>
      </ul>
      <p className="candidate-fate">
        {describeFate(candidate)}
        {candidate.finalScore === null
          ? ""
          : ` · reranked score ${formatScore(candidate.finalScore)}`}
      </p>
    </li>
  );
}

function PromptView({ prompt }: { prompt: WireInspection["prompt"] }) {
  const share = budgetShare(prompt);
  return (
    <div className="inspector-prompt">
      {prompt.sent ? null : (
        <p className="notice">
          The model was not called with this prompt: the book had nothing good enough to answer
          from.
        </p>
      )}
      <p className="inspector-tokens">
        <label>
          Sources: {prompt.sourceTokens} of {prompt.budget} tokens
          <meter
            min={0}
            max={1}
            value={share}
            aria-label="Share of the token budget used by the sources"
          />
        </label>
        <span className="muted"> · {prompt.version}</span>
      </p>
      <details>
        <summary>System message</summary>
        <pre>{prompt.system}</pre>
      </details>
      <details>
        <summary>Question</summary>
        <pre>{prompt.user}</pre>
      </details>
    </div>
  );
}

function Stages({ trace }: { trace: WireTrace }) {
  const usage = describeUsage(trace.usage);
  return (
    <div>
      <ol className="stages">
        {trace.stages.map((stage, index) => (
          <li
            key={`${stage.stage}-${index.toString()}`}
            className={stage.status === "error" ? "stage-error" : ""}
          >
            <span className="stage-name">{stage.stage}</span>
            <span className="muted">{formatMs(stage.durationMs)}</span>
            <span className="stage-summary">
              {summaryPairs(stage)
                .map(([key, value]) => `${key} ${value}`)
                .join(" · ")}
              {stage.error === undefined ? "" : ` · ${stage.error}`}
            </span>
          </li>
        ))}
      </ol>
      <p className="muted">
        Total {formatMs(trace.totalMs)}
        {usage === "" ? "" : ` · ${usage}`}
      </p>
    </div>
  );
}

/**
 * What happened behind one answer: the chunks retrieval found (who found each, where reranking put
 * it, whether it reached the prompt), the prompt and how much of its budget the sources took, and
 * what each stage did. It only draws what the API sent; nothing is computed here but wording.
 */
export function InspectorPanel({ inspection, trace }: InspectorPanelProps) {
  const { candidates, prompt } = inspection;
  const used = candidates.filter((c) => c.fate === "used").length;
  return (
    <details className="inspector">
      <summary>Inspect this answer</summary>

      <section aria-label="Retrieved chunks">
        <h3>
          Retrieved chunks{" "}
          <span className="muted">
            ({candidates.length} found, {used} used)
          </span>
        </h3>
        {candidates.length === 0 ? (
          <p className="muted">Retrieval found nothing.</p>
        ) : (
          <>
            {rerankChangedAnything(candidates) ? null : (
              <p className="muted">The reranker kept every chunk in its place.</p>
            )}
            <ol className="candidates">
              {candidates.map((candidate) => (
                <Candidate key={candidate.chunkId} candidate={candidate} />
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-label="Prompt">
        <h3>Prompt</h3>
        <PromptView prompt={prompt} />
      </section>

      {trace === undefined ? null : (
        <section aria-label="Stages">
          <h3>Stages</h3>
          <Stages trace={trace} />
        </section>
      )}
    </details>
  );
}
