// createAgentTasks の taskStorage（core/agent-tasks.mjs）に、保存の前後で割り込む道具。
// beforeSave(rows) が投げれば保存の失敗、止めれば保存の保留になる。afterSave は書けた後
import { openData } from '../../core/data-schema.mjs';
import { taskTable } from '../../core/db.mjs';

export function hookedTaskStorage(dir, { beforeSave, afterSave } = {}) {
  const handle = openData(dir);
  const rows = taskTable(handle.db);
  const state = { saves: 0, written: [] };
  const taskStorage = {
    loadRows: () => rows.loadRows(),
    async save(list) {
      state.saves++;
      await beforeSave?.(list);
      rows.save(list);
      state.written.push(list.map(([id]) => id));
      await afterSave?.(list);
    },
  };
  return { taskStorage, state, close: () => handle.release() };
}
