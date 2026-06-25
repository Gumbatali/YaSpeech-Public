openapi: "3.0.0"
info:
  title: YaSpeech API Gateway
  version: "1.0"

paths:
  # ── Auth: жёсткий лимит (анти-брутфорс) ─────────────────────────────────────
  /api/auth/login:
    post:
      x-yc-apigateway-rate-limit:
        allRequests:
          rps: 2
          burst: 5
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${API_FUNCTION_ID}
        service_account_id: ${SA_ID}
      responses:
        "200":
          description: OK

  /api/auth/register:
    post:
      x-yc-apigateway-rate-limit:
        allRequests:
          rps: 1
          burst: 3
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${API_FUNCTION_ID}
        service_account_id: ${SA_ID}
      responses:
        "200":
          description: OK

  /api/auth/logout:
    post:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${API_FUNCTION_ID}
        service_account_id: ${SA_ID}
      responses:
        "200":
          description: OK

  /api/auth/me:
    get:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${API_FUNCTION_ID}
        service_account_id: ${SA_ID}
      responses:
        "200":
          description: OK

  # ── Все остальные /api/* — общий лимит 30 rps ────────────────────────────────
  /api/{path+}:
    x-yc-apigateway-any-method:
      x-yc-apigateway-rate-limit:
        allRequests:
          rps: 30
          burst: 60
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${API_FUNCTION_ID}
        service_account_id: ${SA_ID}
      parameters:
        - name: path
          in: path
          required: false
          schema:
            type: string

  # ── Фронтенд из Object Storage ───────────────────────────────────────────────
  /:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${FRONTEND_BUCKET}
        object: index.html
        service_account_id: ${SA_ID}
      responses:
        "200":
          description: OK

  /app/{path+}:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${FRONTEND_BUCKET}
        object: "app/{path}"
        service_account_id: ${SA_ID}
      parameters:
        - name: path
          in: path
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK

  /lib/{path+}:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${FRONTEND_BUCKET}
        object: "lib/{path}"
        service_account_id: ${SA_ID}
      parameters:
        - name: path
          in: path
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK
