/**
 * dshTurnModel.ts — T-2108 (ADR-227 "DSH local corrector"): the model a DeepSeek
 * Harness turn sends, so a chat never crosses between a local server and the cloud.
 *
 * A new chat on a local server is started by its qualified local model id
 * (`nassaj_local_<hex>/<model>`). The server records that id with the chat's pin
 * and is the only source of a local chat's model on resume: it uses the recorded
 * id when the turn names a non-local model or none, and refuses a local id on a
 * cloud chat. So a resumed turn never sends a local id.
 */
import { isLocalModelId } from '../../../../shared/localEngine';

/** The composer pick for a new chat; on resume, no local id (undefined = no model). */
export function dshTurnModel(resume: boolean, composerModel: string): string | undefined {
  return resume && isLocalModelId(composerModel) ? undefined : composerModel;
}
