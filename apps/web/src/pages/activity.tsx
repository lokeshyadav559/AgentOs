import { api } from "../api";
import { Card, useApi, Empty } from "../ui";
import { ActivityList } from "./overview";

export function ActivityPage() {
  const activity = useApi(() => api.activity(), []);
  return (
    <div className="page">
      <h1>Activity</h1>
      <Card>
        {(activity.data ?? []).length === 0 ? <Empty>Nothing yet.</Empty> : <ActivityList events={activity.data ?? []} />}
      </Card>
    </div>
  );
}

