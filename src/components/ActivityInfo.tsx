import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAccess } from "../contexts/AuthContext";
import { colorForName, initials } from "../lib/avatar";
import { listLastActivity, type LastActivity } from "../lib/db";
import { formatDateTime, formatTimeAgo } from "../lib/format";

/**
 * "Who changed this" in the cadastros, read from the activity log: a
 * column for the lists and a footer inside a record. Records last changed
 * before the log existed show "—".
 */

/** Who last changed each of `ids` (keyed by id as text). */
export function useLastActivity(entityType: string, ids: (number | string)[]): Map<string, LastActivity> {
  const [map, setMap] = useState<Map<string, LastActivity>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setMap(new Map());
      return;
    }
    listLastActivity(entityType, ids)
      .then((rows) => !cancelled && setMap(new Map(rows.map((r) => [String(r.entityId), r]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, key]);
  return map;
}

function firstName(name: string): string {
  return name.includes("@") ? name : name.split(" ")[0];
}

/** "Fulana · há 2 dias" with her initials; `fallback` (or "—") when the log has nothing. */
export function UpdatedByCell({ info, fallback }: { info: LastActivity | undefined; fallback?: string }) {
  if (!info) return <span className="muted">{fallback ?? "—"}</span>;
  return (
    <span className="updated-by" title={`${info.actorName} · ${formatDateTime(info.at)}`}>
      <span className="updated-by-avatar" style={{ background: colorForName(info.actorName) }} aria-hidden="true">
        {initials(info.actorName)}
      </span>
      {firstName(info.actorName)} <span className="muted">· {formatTimeAgo(info.at)}</span>
    </span>
  );
}

/** Inside a record: "Criado por … · Atualizado por …", and "Ver alterações" for who can see Atividade. */
export function RecordActivityFooter({ entityType, id }: { entityType: string; id: number | string | null | undefined }) {
  const { canManageUsers } = useAccess();
  const map = useLastActivity(entityType, id === null || id === undefined ? [] : [id]);
  const info = id === null || id === undefined ? undefined : map.get(String(id));
  if (!info) return null;
  const created = /^(criou|cadastrou|importou|duplicou)/.test(info.firstVerb);
  return (
    <div className="record-activity">
      <span>
        {created && (
          <>
            Criado por <b>{info.firstActorName}</b> em {formatDateTime(info.firstAt)}
            {info.total > 1 && " · "}
          </>
        )}
        {(!created || info.total > 1) && (
          <>
            Atualizado por <b>{info.actorName}</b> {formatTimeAgo(info.at)}
          </>
        )}
      </span>
      {canManageUsers && (
        <Link className="record-activity-link" to={`/activity?entityType=${entityType}&entityId=${id}`}>
          Ver alterações
        </Link>
      )}
    </div>
  );
}
