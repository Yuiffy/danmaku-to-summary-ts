jest.mock('node-fetch', () => jest.fn());
jest.mock('./config-loader', () => ({
  getConfig: jest.fn(),
  getDaiYuApiKey: jest.fn(),
  isDaiYuTextConfigured: jest.fn(),
  getByPath: jest.fn(),
}));

const fetchMock = require('node-fetch') as jest.Mock;
const configLoader = require('./config-loader');
const {
  generateTextWithDaiYu,
  generateTextWithTuZi,
} = require('./ai_text_generator');

describe('daiYu model routing', () => {
  const legacyModel = ['gpt', '5.4', 'mini'].join('-');
  const config = {
    ai: {
      text: {
        daiYu: {
          enabled: true,
          model: legacyModel,
          fallbackModels: [legacyModel],
          temperature: 0.7,
          maxTokens: 1000,
          thinking: { enabled: true, budgetTokens: 1024 },
        },
      },
    },
    timeouts: { aiApiTimeout: 5000 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configLoader.getConfig.mockReturnValue(config);
    configLoader.getDaiYuApiKey.mockReturnValue('test-key');
    configLoader.isDaiYuTextConfigured.mockReturnValue(true);
    configLoader.getByPath.mockReturnValue(100);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'LUNA_OK' },
          finish_reason: 'stop',
        }],
        usage: {},
      }),
    });
  });

  test('normalizes a legacy daiYu configuration before sending the request', async () => {
    const result = await generateTextWithDaiYu('只回复 LUNA_OK');

    expect(result.text).toBe('LUNA_OK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-5.6-luna');
  });

  test('routes a legacy GPT-5 model from the tuZi compatibility entry to Luna', async () => {
    const result = await generateTextWithTuZi('只回复 LUNA_OK', {
      primaryModel: legacyModel,
    });

    expect(result.text).toBe('LUNA_OK');
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe('gpt-5.6-luna');
  });
});
