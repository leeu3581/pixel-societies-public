FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app

# requirements.txt is the human-readable source of truth; requirements.lock
# pins exact versions (generated via `pip freeze` from a validated build) so
# the image is reproducible — the Azure build matches what was tested locally.
COPY backend/requirements.txt backend/requirements.lock ./
RUN pip install -r requirements.lock

COPY backend/app ./app
COPY backend/groups ./groups
COPY backend/data/wikis /opt/seed-wikis
COPY backend/start-azure.sh /app/start-azure.sh
# sprites.py resolves references relative to the repository root (/ in this image).
# Build from the repository root so these canonical assets are available.
COPY public/characters/refs /public/characters/refs
RUN python -c "from app.sprites import PORTRAIT_REF, SHEET_REF; from PIL import Image; [Image.open(p).verify() for p in (PORTRAIT_REF, SHEET_REF)]"
RUN mkdir -p /home/pixel-data && ln -s /home/pixel-data /app/data
EXPOSE 8000
CMD ["sh", "/app/start-azure.sh"]
