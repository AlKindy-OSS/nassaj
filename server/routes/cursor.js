import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import express from 'express';

import { CURSOR_FALLBACK_MODELS } from '../modules/providers/list/cursor/cursor-models.provider.js';
import { PROVIDER_REMOVED_CODE, PROVIDER_REMOVED_MESSAGE } from '../../shared/retiredProviders.js';

const router = express.Router();

// T-1953: Cursor is retired as a body. Every /api/cursor/* request gets the typed
// refusal; the handlers below are unreachable until this router is deleted.
router.use((req, res) => {
  res.status(400).json({ error: PROVIDER_REMOVED_MESSAGE, code: PROVIDER_REMOVED_CODE });
});

// GET /api/cursor/config - Read Cursor CLI configuration.
router.get('/config', async (req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.cursor', 'cli-config.json');

    try {
      const configContent = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configContent);

      res.json({
        success: true,
        config,
        path: configPath,
      });
    } catch (error) {
      // Config doesn't exist or is invalid, so return the UI default shape.
      console.log('Cursor config not found or invalid:', error.message);

      res.json({
        success: true,
        config: {
          version: 1,
          model: {
            modelId: CURSOR_FALLBACK_MODELS.DEFAULT,
            displayName: 'GPT-5',
          },
          permissions: {
            allow: [],
            deny: [],
          },
        },
        isDefault: true,
      });
    }
  } catch (error) {
    console.error('Error reading Cursor config:', error);
    res.status(500).json({
      error: 'Failed to read Cursor configuration',
      details: error.message,
    });
  }
});

export default router;
