import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;

  console.log('WebSocket connection:', connectionId);

  return {
    statusCode: 200,
    body: 'Connected',
  };
};
