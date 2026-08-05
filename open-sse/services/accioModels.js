/**
 * Accio model catalog — re-exports protocol catalog (single source of truth).
 */

export {
  getAccioModelConfig,
  resolveAccioModels,
  invalidateAccioCatalog,
  clearAccioCatalog,
} from "../protocol/accio/index.js";
