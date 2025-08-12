# shd-enqueue-transcode

DigitalOcean Functions “web” action to enqueue transcode jobs into Redis for the droplet worker.

## Deploy
doctl serverless connect
export $(cat .env | xargs) && npm run deploy

## Invoke
# Health
curl -i "https://<YOUR-ENDPOINT>/default/enqueue-transcode"

# Enqueue
curl -i -X POST "https://<YOUR-ENDPOINT>/default/enqueue-transcode" \
  -H "Content-Type: application/json" \
  -d '{"spaceKey":"uploads/test.mp4","originalFilename":"test.mp4","contentType":"video/mp4"}'
