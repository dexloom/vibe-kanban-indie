import Foundation

/// One selectable pipeline stage. Mirrors `shared/types.ts` `PipelineStep`
/// (canonical list defined in Rust `default_pipeline_steps()`).
struct PipelineStep: Identifiable, Hashable {
    let id: String
    let label: String
    let promptFragment: String
    let defaultEnabled: Bool

    /// The built-in catalog (kept in sync with `DEFAULT_PIPELINE_STEPS`).
    static let defaults: [PipelineStep] = [
        .init(id: "orchestrate", label: "Orchestrate (auto-drive)",
              promptFragment: "Have the orchestrator agent pick this card up and drive it to done autonomously, running the card's pipeline stages in order — regardless of which board column the card is in (it may be started even from Todo).",
              defaultEnabled: false),
        .init(id: "spec", label: "Create spec",
              promptFragment: "Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing.",
              defaultEnabled: false),
        .init(id: "plan", label: "Create plan",
              promptFragment: "Write a step-by-step implementation plan and save it to `IMPLEMENTATION_PLAN.md` at the repo root.",
              defaultEnabled: false),
        .init(id: "plan-review", label: "Review plan",
              promptFragment: "Have the implementation plan reviewed (e.g. a codex plan review, read-only) and resolve blockers before writing code.",
              defaultEnabled: false),
        .init(id: "wait-for-approval", label: "Wait for approval",
              promptFragment: "Pause for operator approval at this point: commit the work so far, then stop and wait for the operator's decision or instructions before continuing to later stages — do not advance on your own until the operator responds.",
              defaultEnabled: false),
        .init(id: "code-review", label: "Review via Codex",
              promptFragment: "After implementing, run an independent Codex review of the card's diff (the `codex-review` skill / Codex CLI), iterating until it reports no significant findings. Address confirmed findings and re-verify before marking the card ready.",
              defaultEnabled: false),
        .init(id: "update-docs", label: "Update documentation",
              promptFragment: "Update the documentation affected by this change so the docs match what shipped, and commit it before marking the card ready.",
              defaultEnabled: false),
        .init(id: "merge", label: "Merge to base",
              promptFragment: "When the work is implemented and reviewed, merge this card's branch into the base branch.",
              defaultEnabled: false),
        .init(id: "pr", label: "Open pull request",
              promptFragment: "When the work is implemented and reviewed, open a pull request for this card against the base branch.",
              defaultEnabled: false),
    ]
}

/// Port of `web-core/src/shared/lib/pipeline/cardPipeline.ts`: composes and
/// appends the `## Pipeline` block to a card description so the orchestrator can
/// read the pinned agent + stages.
enum CardPipeline {
    static let start = "<!-- vk:pipeline:start -->"
    static let end = "<!-- vk:pipeline:end -->"

    /// The directive line pinning the card to an execution agent (or "" if none).
    static func executorLine(_ executor: String?) -> String {
        let trimmed = (executor ?? "").trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return "" }
        return "- Run this card with the **\(trimmed)** execution agent: pass `executor: \"\(trimmed)\"` when starting the workspace."
    }

    /// Compose the delimited block from ticked steps (catalog order), an optional
    /// pinned agent, and free text. Returns "" when nothing is selected.
    static func composeBlock(steps: [PipelineStep], enabledIds: Set<String>,
                             customText: String, executor: String?) -> String {
        let stepBullets = steps.filter { enabledIds.contains($0.id) }.map { "- \($0.promptFragment)" }
        let execLine = executorLine(executor)
        let bullets = execLine.isEmpty ? stepBullets : [execLine] + stepBullets
        let trimmedCustom = customText.trimmingCharacters(in: .whitespacesAndNewlines)

        if bullets.isEmpty && trimmedCustom.isEmpty { return "" }

        var lines = ["## Pipeline", ""]
        lines.append(contentsOf: bullets)
        if !trimmedCustom.isEmpty {
            if !bullets.isEmpty { lines.append("") }
            lines.append(trimmedCustom)
        }
        return "\(start)\n\(lines.joined(separator: "\n"))\n\(end)"
    }

    /// Append (or replace) the block at the end of a description, idempotently.
    static func appendToDescription(_ description: String?, block: String) -> String {
        let base = stripBlock(description ?? "")
        if block.isEmpty { return base }
        return base.isEmpty ? block : "\(base)\n\n\(block)"
    }

    private static func stripBlock(_ description: String) -> String {
        guard let startRange = description.range(of: start) else { return description }
        let head = String(description[description.startIndex..<startRange.lowerBound])
        if let endRange = description.range(of: end, range: startRange.upperBound..<description.endIndex) {
            let tail = String(description[endRange.upperBound...])
            return (head + tail).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        }
        return head.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    }
}
