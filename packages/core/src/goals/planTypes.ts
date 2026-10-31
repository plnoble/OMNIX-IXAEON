export type StepStatus = 'pending' | 'doing' | 'done' | 'skipped' | 'blocked';
export type StepLink = { kind: 'todo' | 'coding_task' | 'research_topic'; refId: string };

export interface Plan {
  goal_id: string;
  version: number;
  created_at: string;
  reason: string;
  assumptions_json: string;
  status: 'current' | 'superseded' | 'abandoned';
  superseded_by: number | null;
}

export interface PlanStep {
  id: string;
  goal_id: string;
  plan_version: number;
  seq: number;
  title: string;
  detail: string;
  status: StepStatus;
  linked_kind: StepLink['kind'] | null;
  linked_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddVersionInput {
  reason: string;
  assumptions: string[];
  steps: Array<{ title: string; detail?: string }>;
}
