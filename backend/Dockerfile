FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY ["Hospital_data (1).xlsx", "./data/Hospital_data.xlsx"]

EXPOSE 5001

CMD ["sh", "-c", "python seed.py && gunicorn app:app --workers 2 --threads 4 --timeout 120 --bind 0.0.0.0:5001"]