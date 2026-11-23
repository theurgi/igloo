# Anthropic's own API, for the messages endpoint and for counting tokens.
# Its other endpoints start batches, upload files and administer the
# organization.
{
  placeholders = [ "ANTHROPIC_API_KEY" ];
  hosts."api.anthropic.com".send.header = "x-api-key";
  allow.messages."api.anthropic.com" = [
    {
      method = "POST";
      path = "v1/messages";
    }
    {
      method = "POST";
      path = "v1/messages/count_tokens";
    }
  ];
}
