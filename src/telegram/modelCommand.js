// Telegram /model command: alias validation, serialization, and result verification.
const { t } = require('../i18n');

// Alias typed in Telegram -> keyword handed to ralphLoop._switchModel
// (every word of the keyword must appear in the model menu option's text).
const MODEL_ALIASES = {
    'sonnet': 'sonnet',
    'claude sonnet': 'sonnet',
    'opus': 'opus',
    'claude opus': 'opus',
    'pro': 'gemini pro',
    'gemini': 'gemini pro',
    'gemini pro': 'gemini pro',
    'flash': 'flash',
    'gemini flash': 'flash',
    'gpt': 'gpt',
};

function resolveModelAlias(input) {
    const key = (input || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key) ? MODEL_ALIASES[key] : null;
}

/**
 * Build the /model handler.
 * - Unknown aliases are rejected before any UI interaction.
 * - Refused while a Ralph/standalone task is running; during the switch the standalone
 *   flag is held so no task (or second switch) can start concurrently.
 * - The result is verified by re-reading the model selector, because _switchModel's
 *   broad text-click fallback can hit an unrelated element and still report success.
 */
function createModelHandler({ ralphLoop, send, log }) {
    return async (arg) => {
        const wanted = (arg || '').trim();
        if (!wanted) {
            const current = await ralphLoop._getCurrentModel();
            await send(`${t('tg.model_current')} \`${current || t('tg.unknown')}\`\n\n${t('tg.model_options')}`);
            return;
        }

        const keyword = resolveModelAlias(wanted);
        if (!keyword) {
            await send(t('tg.model_invalid', { name: wanted }));
            return;
        }
        if (ralphLoop.isBusy()) {
            await send(t('tg.model_busy'));
            return;
        }

        ralphLoop.setStandaloneRunning(true);
        try {
            await send(`${t('tg.model_switching')} *${keyword}*`);
            const clicked = await ralphLoop._switchModel(keyword);
            const current = clicked ? await ralphLoop._getCurrentModel() : null;
            const verified = !!current && keyword.split(' ').every(w => current.toLowerCase().includes(w));
            if (verified) {
                await send(`${t('tg.model_switched')} \`${current}\``);
            } else {
                await send(`${t('tg.model_switch_failed')} \`${keyword}\` (${current || t('tg.unknown')})`);
            }
        } catch (e) {
            if (log) log('[Telegram] /model error: ' + e.message);
            await send(`${t('tg.model_switch_failed')} \`${keyword}\` — ${e.message}`);
        } finally {
            ralphLoop.setStandaloneRunning(false);
        }
    };
}

module.exports = { createModelHandler, resolveModelAlias, MODEL_ALIASES };
