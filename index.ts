import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Type } from '@sinclair/typebox';
import { whimmyPlugin, registerWhimmyHooks, askUserQuestion, getAgentConfig } from './src/channel';
import { setWhimmyRuntime } from './src/runtime';
import { registerWhimmyCli } from './src/setup';
import type { AskUserQuestion } from './src/types';

const AskUserQuestionParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: 'The question text to display' }),
      header: Type.String({ description: 'Short header/title for the question' }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: 'Short label for the option' }),
          description: Type.String({ description: 'Longer description of what this option means' }),
        }),
        { description: 'Available options for the user to choose from' },
      ),
      multiSelect: Type.Boolean({
        description: 'Whether the user can select multiple options (true) or just one (false)',
        default: false,
      }),
    }),
    { description: 'Array of questions to present to the user' },
  ),
});

const plugin = {
  id: 'whimmy',
  name: 'Whimmy Channel',
  description: 'Whimmy multi-agent messenger channel via WebSocket',
  configSchema: { schema: { type: 'object', properties: {}, additionalProperties: true } },
  register(api: OpenClawPluginApi): void {
    setWhimmyRuntime(api.runtime);
    api.registerChannel({ plugin: whimmyPlugin });
    registerWhimmyCli(api);
    registerWhimmyHooks(api);

    // Register AskUserQuestion tool. Plugin-registered tools bypass
    // before_tool_call hooks, so the forwarding logic lives in execute().
    api.registerTool((ctx) => ({
      name: 'AskUserQuestion',
      label: 'Ask User Question',
      description:
        'Present the user with one or more questions, each with a set of options to choose from. ' +
        'Use this when you need the user to make a choice or confirm something before proceeding. ' +
        'The user will see the questions in the Whimmy app and can select their answers interactively.',
      parameters: AskUserQuestionParams,
      async execute(_toolCallId, params) {
        const questions = (params.questions ?? []) as AskUserQuestion[];
        if (questions.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No questions provided.' }],
            details: {},
          };
        }

        // Extract session info from the tool context.
        const sessionKey = ctx.sessionKey ?? '';
        const agentId = ctx.agentId ?? 'default';

        // Strip the "agent:{agentId}:direct:" prefix to get the Whimmy session key.
        const parts = sessionKey.split(':');
        const whimmySessionKey = parts.length >= 4 ? parts.slice(3).join(':') : sessionKey;

        const agentCfg = getAgentConfig(agentId);
        const timeoutMs = agentCfg?.askUserQuestion?.timeoutMs ?? 120_000;

        try {
          const answers = await askUserQuestion(
            whimmySessionKey,
            agentId,
            questions,
            timeoutMs,
          );

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(answers) }],
            details: { answers },
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `User did not respond: ${err.message}` }],
            details: { error: err.message },
          };
        }
      },
    }));
  },
};

export default plugin;
