import SwiftUI

/// Inline approval request (analogue of `ChatApprovalCard`): a tool gate, a
/// questionnaire, or a plan approval.
struct ApprovalCardView: View {
    let approval: ApprovalInfo
    var onRespond: (ApprovalOutcome) -> Void

    @State private var selections: [String: Set<String>] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            switch approval.kind {
            case .tool: toolBody
            case .question: questionBody
            case .planApproval: planBody
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: FlightDeck.Radius.card).fill(FlightDeck.warning.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: FlightDeck.Radius.card).strokeBorder(FlightDeck.warning.opacity(0.4)))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5).fill(FlightDeck.warning).frame(width: 3).padding(.vertical, 2)
        }
    }

    private var header: some View {
        HStack {
            Image(systemName: "questionmark.circle.fill").foregroundStyle(FlightDeck.warning)
            Text(headerText).font(.fd(14, .semibold)).foregroundStyle(FlightDeck.text)
            Spacer()
            Text(approval.timeoutAt, style: .relative).font(.fdMono(11)).foregroundStyle(FlightDeck.textFaint)
        }
    }

    private var headerText: String {
        switch approval.kind {
        case .tool: return "Allow “\(approval.toolName)”?"
        case .question: return "Agent has a question"
        case .planApproval: return "Approve plan?"
        }
    }

    // MARK: - Tool

    private var toolBody: some View {
        HStack {
            Button(role: .destructive) { onRespond(.denied(reason: nil)) } label: {
                Label("Deny", systemImage: "xmark")
            }
            Spacer()
            Button { onRespond(.approved) } label: {
                Label("Approve", systemImage: "checkmark")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Question

    private var questionBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(approval.questions ?? []) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header { Text(header).font(.caption.weight(.semibold)) }
                    Text(q.question).font(.callout)
                    ForEach(q.options) { option in
                        Toggle(isOn: binding(for: q, option: option)) {
                            VStack(alignment: .leading) {
                                Text(option.label)
                                if let d = option.description {
                                    Text(d).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .toggleStyle(.checkbox)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Submit answers") { onRespond(.answered(answers: buildAnswers())) }
                    .buttonStyle(.borderedProminent)
                    .disabled(buildAnswers().allSatisfy { $0.answer.isEmpty })
            }
        }
    }

    private func binding(for q: ApprovalQuestion, option: ApprovalQuestionOption) -> Binding<Bool> {
        Binding(
            get: { selections[q.question]?.contains(option.label) ?? false },
            set: { on in
                var set = selections[q.question] ?? []
                if on {
                    if !q.multiSelect { set.removeAll() }
                    set.insert(option.label)
                } else {
                    set.remove(option.label)
                }
                selections[q.question] = set
            }
        )
    }

    private func buildAnswers() -> [QuestionAnswer] {
        (approval.questions ?? []).map { q in
            QuestionAnswer(question: q.question, answer: Array(selections[q.question] ?? []))
        }
    }

    // MARK: - Plan

    private var planBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let plan = approval.planContent {
                ScrollView { MarkdownText(text: plan) }.frame(maxHeight: 220)
            }
            HStack {
                Button(role: .destructive) { onRespond(.denied(reason: nil)) } label: { Text("Reject") }
                Spacer()
                Button("Approve") { onRespond(.approved) }.buttonStyle(.borderedProminent)
            }
        }
    }
}
