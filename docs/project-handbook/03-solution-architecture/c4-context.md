# C4 Context

Схема уровня `System Context`: кто взаимодействует с системой и какие внешние платформы участвуют.

```mermaid
flowchart LR
  User["Пользователь встречи"] --> System["YaSpeech MVP"]
  Manager["Менеджер / владелец продукта"] --> System
  Admin["Облачный администратор"] --> System

  System --> SpeechSense["Yandex SpeechSense"]
  System --> AIStudio["Yandex AI Studio"]
  System --> ObjectStorage["Yandex Object Storage"]
  System --> CloudServices["Yandex Cloud serverless-сервисы"]

  SpeechSense --> AIStudio
```

## Пояснение

- `Пользователь встречи` загружает аудио и получает протокол.
- `Менеджер / владелец продукта` определяет правила использования и сценарии.
- `Облачный администратор` настраивает доступы и инфраструктуру.
- `YaSpeech MVP` является продуктовой обёрткой над сервисами Яндекса.
