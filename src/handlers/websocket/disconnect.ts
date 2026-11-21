import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';


export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;

  console.log('WebSocket disconnected', {
    connectionId,
  });

  return {
    statusCode: 200,
    body: 'Disconnected',
  };
};
