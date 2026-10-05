import {
  chooseCandidateModel,
  getTokenFactoryConfig,
  listTokenFactoryModels,
  runTokenFactoryChat,
  TokenFactoryError
} from "./tokenFactory.js";

const shouldRunChat = process.argv.includes("--chat");
try { process.loadEnvFile('.env'); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load local .env configuration.'); }
const config = getTokenFactoryConfig();

try {
  const models = await listTokenFactoryModels(config);
  const candidate = chooseCandidateModel(models, config.model);
  const result = {
    status: "model_listing_verified",
    liveInferenceVerified: false,
    baseUrl: config.baseUrl,
    modelCount: models.length,
    configuredModelFound: config.model ? Boolean(candidate) : null,
    candidateModel: candidate ? {
      id: candidate.id,
      name: candidate.name || null,
      ownedBy: candidate.owned_by || null
    } : null,
    liveChat: null
  };

  if (shouldRunChat) {
    if (!candidate?.id) {
      throw new Error("No model is available for live chat preflight");
    }
    const chat = await runTokenFactoryChat({
      ...config,
      model: config.model || candidate.id,
      prompt: "Reply with exactly: token-factory-preflight-ok"
    });
    result.liveChat = {
      status: "ok",
      model: chat.model,
      contentPreview: chat.content.slice(0, 120)
    };
    result.status = "live_inference_verified";
    result.liveInferenceVerified = true;
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    status: "not_verified",
    reason: error instanceof Error ? error.message : String(error)
  };

  if (error instanceof TokenFactoryError) {
    result.code = error.code;
    result.httpStatus = error.status;
    result.response = error.body;
  }

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = /NEBIUS_API_KEY/.test(result.reason) ? 78 : 1;
}
