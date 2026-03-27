# Contador SaaS Blueprint

## Endpoints

- `/app`
  - interfaz cliente por empresa
- `/saas`
  - interfaz superadmin SaaS
- `/api/*`
  - endpoints operativos de empresa
- `/api/saas/*`
  - endpoints de control SaaS

## Modulos

- Autenticacion
  - login, logout, sesion actual, registro de empresa
- Multiempresa
  - companies, plans, subscriptions, configs
- Operacion
  - upload, cola, documentos, asignacion, reintentos
- Equipo
  - usuarios por empresa, roles, activacion
- Auditoria
  - acciones por usuario y por empresa
- Billing
  - pagos, plan, vencimientos, estado de suscripcion
- SaaS Admin
  - dashboard global, empresas, uso, pagos

## Roles

- `superadmin`
  - acceso al panel SaaS
- `admin`
  - administra usuarios y asignaciones dentro de su empresa
- `user`
  - trabaja documentos asignados
- `viewer`
  - consulta sin administrar

## Tablas clave

- `plans`
- `companies`
- `users`
- `subscriptions`
- `payments`
- `configs`
- `documents`
- `usage_logs`
- `audit_logs`

## Flujo principal

1. Una empresa se registra.
2. Se crea company, admin inicial, config y subscription trial.
3. Los usuarios cargan PDFs.
4. Cada documento queda asignado y entra a cola.
5. El worker procesa y guarda extraccion.
6. Si falla, reintenta y deja auditoria.
7. El panel SaaS controla planes, pagos, estado y uso.

## Siguiente nivel recomendado

- Recuperacion de contrasena por email
- Cambio de clave por usuario
- Integracion de pagos real
- OCR para PDFs escaneados
- API keys cifradas
- Worker desacoplado en servicio aparte
- Reportes financieros y exportaciones avanzadas
