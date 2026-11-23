# OpenRouter's model calls, in each of the three shapes harnesses speak, and
# the catalogs a client reads at startup. Its other endpoints mint keys and
# read the account's spending, and a key that may call a model is not thereby
# one that may do those. Its Responses endpoint stores nothing, so no later
# request can read one back.
{
  placeholders = [ "OPENROUTER_API_KEY" ];
  hosts."openrouter.ai".send = "bearer";
  allow.models."openrouter.ai" = [
    {
      method = "POST";
      path = "api/v1/chat/completions";
    }
    {
      method = "POST";
      path = "api/v1/messages";
    }
    {
      method = "POST";
      path = "api/v1/responses";
    }
    {
      method = "GET";
      path = "api/v1/models";
    }
    {
      method = "GET";
      path = "api/v1/embeddings/models";
    }
    {
      method = "GET";
      path = "api/v1/images/models";
    }
    {
      method = "GET";
      path = "api/v1/videos/models";
    }
  ];
}
