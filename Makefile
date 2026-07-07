.PHONY: up down logs ps clean

# Build images and start the full stack in the foreground.
up:
	docker compose up --build

# Stop and remove containers (keeps named volumes / data).
down:
	docker compose down

# Tail logs from all services.
logs:
	docker compose logs -f

# Show status of all services.
ps:
	docker compose ps

# Stop everything and remove named volumes (wipes MongoDB data + audio/image caches).
clean:
	docker compose down -v
