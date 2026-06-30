import type {
  SpecKitStage,
  SpecKitStageState,
  SpecKitArtifacts,
  SpecKitTasks,
} from 'shared/types';

export interface StageMeta {
  stage: SpecKitStage;
  label: string;
  blurb: string;
  /** Whether the stage takes a free-form text input before running. */
  takesInput: boolean;
}

/** The SpecKit stages in workflow order, with workbench display metadata. */
export const STAGES: StageMeta[] = [
  {
    stage: 'constitution',
    label: 'Constitution',
    blurb: 'Project principles every feature must honor.',
    takesInput: true,
  },
  {
    stage: 'specify',
    label: 'Specify',
    blurb: 'What to build and why — functional spec (spec.md).',
    takesInput: true,
  },
  {
    stage: 'clarify',
    label: 'Clarify',
    blurb: 'Resolve underspecified areas in the spec.',
    takesInput: true,
  },
  {
    stage: 'plan',
    label: 'Plan',
    blurb: 'Technical approach + data model + contracts (plan.md).',
    takesInput: false,
  },
  {
    stage: 'tasks',
    label: 'Tasks',
    blurb: 'Dependency-ordered, parallel-aware task list (tasks.md).',
    takesInput: false,
  },
  {
    stage: 'analyze',
    label: 'Analyze',
    blurb: 'Cross-check spec, plan, and tasks for gaps.',
    takesInput: false,
  },
  {
    stage: 'implement',
    label: 'Implement',
    blurb: 'Execute the task list in the feature worktree.',
    takesInput: false,
  },
];

const CLARIFICATION_MARKER = '[NEEDS CLARIFICATION';

/**
 * Derive a stage's badge state from the artifacts/tasks on disk plus whichever
 * stage (if any) is currently running. Best-effort: SpecKit doesn't persist
 * per-stage status, so we infer it from the artifacts each stage produces.
 */
export function computeStageState(
  stage: SpecKitStage,
  artifacts: SpecKitArtifacts | null,
  tasks: SpecKitTasks | null,
  runningStage: SpecKitStage | null
): SpecKitStageState {
  if (runningStage === stage) return 'running';
  if (!artifacts) return 'idle';

  switch (stage) {
    case 'constitution':
      // The constitution lives outside the feature dir; treated as available.
      return 'idle';
    case 'specify':
      return artifacts.spec.exists ? 'done' : 'idle';
    case 'clarify': {
      if (!artifacts.spec.exists) return 'idle';
      const hasOpenQuestions = (artifacts.spec.content ?? '').includes(
        CLARIFICATION_MARKER
      );
      return hasOpenQuestions ? 'needs_attention' : 'done';
    }
    case 'plan':
      return artifacts.plan.exists ? 'done' : 'idle';
    case 'tasks':
      return artifacts.tasks.exists ? 'done' : 'idle';
    case 'analyze':
      return 'idle';
    case 'implement': {
      if (!tasks || tasks.total === 0) return 'idle';
      return tasks.completed === tasks.total ? 'done' : 'idle';
    }
    default:
      return 'idle';
  }
}
