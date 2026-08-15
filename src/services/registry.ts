/**
 * Services registry: the aggregate root all subsystems share. Type-only
 * imports keep this free of runtime cycles.
 */
import type { DB } from "../db/client.js";
import type { Config } from "../config.js";
import type { TaskService } from "./tasks.js";
import type { FileService } from "./files.js";
import type { GoalService } from "./goals.js";
import type { InboxService } from "./inbox.js";
import type { SessionService } from "./sessions.js";
import type { ActivityService } from "./activity.js";
import type { PushService } from "./push.js";
import type { SecretService } from "./secrets.js";
import type { SchedulerService } from "./scheduler.js";
import type { TriggerService } from "./triggers.js";
import type { ProjectService } from "./projects.js";

export interface Services {
  db: DB;
  config: Config;
  projects: ProjectService;
  tasks: TaskService;
  files: FileService;
  goals: GoalService;
  inbox: InboxService;
  sessions: SessionService;
  activity: ActivityService;
  push: PushService;
  secrets: SecretService;
  scheduler: SchedulerService;
  triggers: TriggerService;
}
