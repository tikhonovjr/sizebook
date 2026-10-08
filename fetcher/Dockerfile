FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth libgtk-3-0 libx11-xcb1 libdbus-glib-1-2 libasound2 libxtst6 libxrandr2 libxcomposite1 \
    libxdamage1 libpci3 libgl1 fonts-dejavu fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && python -m camoufox fetch
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "app.py"]
